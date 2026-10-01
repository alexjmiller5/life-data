// The shared fixture is the contract between the Python validator
// (life_data.catalog.validate_row) and this one, which the hub and every UI
// client run.
import { describe, expect, test } from "bun:test";
import cases from "../../tests/fixtures/validation-cases.json";
import { validateRow, type Property, type Row } from "../src/validate.ts";

type Case = {
  name: string; properties: Property[]; before: Row | null; after: Row;
  expect: { col: string; rule: string }[]; refs?: Record<string, string[]>;
  extra_options?: Record<string, string[]>; in_derive?: string[]; touched?: string[];
};

describe("validateRow conformance", () => {
  for (const c of cases as Case[]) {
    test(c.name, () => {
      const refs = c.refs ?? {};
      const extra = c.extra_options ?? {};
      const got = validateRow(c.properties, c.before, c.after, {
        inDerive: new Set(c.in_derive ?? []),
        refOk: (t, id) => (refs[t] ?? []).includes(String(id)),
        extraOptions: (p) => extra[p.col] ?? [],
        touched: c.touched ? new Set(c.touched) : null,
      });
      expect(got.map((v) => ({ col: v.col, rule: v.rule }))).toEqual(c.expect);
    });
  }
});
