/**
 * An on-device chat on Android with cactus-react-native, traced.
 *
 * Modelled on how the LiquidChat app uses cactus: one `CactusLM` per model,
 * `download()` then `init()`, then `complete({ messages, onToken })`, with the
 * engine's own metrics shown under each reply.
 *
 * Copy this file and `telemetry.ts` into a React Native 0.81 project; see the
 * README next to it.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Button, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { CactusLM, type CactusLMMessage } from 'cactus-react-native';
import { flushTelemetry } from '@traceverse/genai-otel-instrument';
import { SESSION_ID, startTelemetry } from './telemetry';

// Before any CactusLM is used: the classes are patched here.
startTelemetry();

const MODEL = 'lfm2-350m';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  detail?: string;
}

export default function App(): React.JSX.Element {
  const model = useRef<CactusLM | null>(null);
  const [status, setStatus] = useState('Starting...');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('What is the capital of France?');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [live, setLive] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const lm = new CactusLM({ model: MODEL });
        setStatus(`Downloading ${MODEL}...`);
        // Span: cactus.download
        await lm.download({ onProgress: (progress) => setStatus(`Downloading ${MODEL}: ${Math.round(progress * 100)}%`) });
        setStatus(`Loading ${MODEL}...`);
        // Span: cactus.init
        await lm.init();
        if (cancelled) return;
        model.current = lm;
        setReady(true);
        setStatus('Ready.');
      } catch (error) {
        setStatus(`Failed to load the model: ${String(error)}`);
      }
    })();
    return () => {
      cancelled = true;
      void model.current?.destroy();
    };
  }, []);

  const send = useCallback(async () => {
    const lm = model.current;
    const text = prompt.trim();
    if (!lm || !text) return;
    setBusy(true);
    setLive('');
    const history: Turn[] = [...turns, { role: 'user', content: text }];
    setTurns(history);
    try {
      const messages: CactusLMMessage[] = [
        { role: 'system', content: 'You are a helpful assistant. Answer briefly.' },
        ...history.map(({ role, content }) => ({ role, content })),
      ];
      // Span: cactus.complete - tokens, time to first token, decode speed and
      // memory are read from the engine's own result.
      const result = await lm.complete({
        messages,
        options: { maxTokens: 128, temperature: 0.2 },
        onToken: (token) => setLive((current) => current + token),
      });
      setTurns([
        ...history,
        {
          role: 'assistant',
          content: result.response,
          detail: `${result.decodeTokens} tokens, ${result.decodeTps.toFixed(1)} tok/s, first token ${Math.round(result.timeToFirstTokenMs)} ms`,
        },
      ]);
    } catch (error) {
      setTurns([...history, { role: 'assistant', content: `error: ${String(error)}` }]);
    } finally {
      setLive('');
      setBusy(false);
      // Send this turn's spans now rather than at the next batch interval.
      void flushTelemetry(10).then((accepted) => setStatus(accepted ? 'Ready. Telemetry exported.' : 'Ready. Telemetry NOT accepted by the collector.'));
    }
  }, [prompt, turns]);

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.title}>On-device chat</Text>
      <Text testID="status" style={styles.status}>
        {status}
      </Text>
      <Text testID="session" style={styles.status}>
        session.id: {SESSION_ID}
      </Text>
      <ScrollView style={styles.log}>
        {turns.map((turn, index) => (
          <View key={index} style={styles.turn}>
            <Text style={turn.role === 'user' ? styles.user : styles.assistant}>
              {turn.role === 'user' ? 'you' : 'model'}: {turn.content}
            </Text>
            {turn.detail ? <Text style={styles.detail}>{turn.detail}</Text> : null}
          </View>
        ))}
        {live ? <Text style={styles.assistant}>model: {live}</Text> : null}
        {busy && !live ? <ActivityIndicator /> : null}
      </ScrollView>
      <TextInput testID="prompt" style={styles.input} value={prompt} onChangeText={setPrompt} editable={ready && !busy} />
      <Button testID="send" title="Send" onPress={() => void send()} disabled={!ready || busy} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, backgroundColor: '#fff' },
  title: { fontSize: 20, fontWeight: '600', marginBottom: 4 },
  status: { color: '#555', marginBottom: 4 },
  log: { flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 8, marginVertical: 8 },
  turn: { marginBottom: 8 },
  user: { color: '#111' },
  assistant: { color: '#0a4' },
  detail: { color: '#777', fontSize: 12 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 8, marginBottom: 8 },
});
