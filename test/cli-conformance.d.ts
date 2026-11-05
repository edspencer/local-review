// The schema validator the ported cli-contract tests use; @edspencer/cli-conformance ships it without types.
declare module '@edspencer/cli-conformance/dist/src/schema.js' {
  export function loadSchema(name: string): unknown;
  export function validate(schema: unknown, doc: unknown): string[];
}
