// Conformance test: the shared fixture is the contract between the Python
// validator (life_data.catalog.validate_row) and this JS mirror.
import { describe, expect, test } from "bun:test";
import cases from "../../tests/fixtures/validation-cases.json";
import { validateRow } from "../src/validate.js";

describe("validateRow conformance", () => {
  for (const c of cases) {
    test(c.name, () => {
      const refs = c.refs ?? {};
      const extra = c.extra_options ?? {};
      const got = validateRow(c.properties, c.before, c.after, {
        inDerive: new Set(c.in_derive ?? []),
        refOk: (t, id) => (refs[t] ?? []).includes(id),
        extraOptions: (p) => extra[p.col] ?? [],
      });
      expect(got.map((v) => ({ col: v.col, rule: v.rule }))).toEqual(c.expect);
    });
  }
});
