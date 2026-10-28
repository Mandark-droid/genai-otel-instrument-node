/**
 * Names the project a trace belongs to in OpenInference backends. Arize AX
 * rejects an export that names none ("trace export requires project routing");
 * other backends ignore it. The browser and React Native entry sets it to the
 * service name, or to OPENINFERENCE_PROJECT_NAME when passed. The Node entry
 * matches the Python library, which leaves routing to the exporter headers.
 */
export const OPENINFERENCE_PROJECT_NAME = 'openinference.project.name';
