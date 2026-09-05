// Can a tagged template give the SQL text as a literal type? If yes, the
// generated types can be keyed by it. If no, a plain string literal is the
// only way to make a stale type fail tsc.
declare function sqlTag<const S extends readonly string[]>(strings: S & TemplateStringsArray, ...values: unknown[]): S;
const a = sqlTag`select 1`;
type A = typeof a;
const check1: A extends readonly ["select 1"] ? true : false = true;

declare function sqlPlain<const S extends string>(sql: S): S;
const b = sqlPlain("select 1");
const check2: typeof b extends "select 1" ? true : false = true;
export { check1, check2 };
