# False-green patterns

Tests that stay green while the behaviour they claim to prove is broken. Each entry: the symptom, how to spot it, the fix. Grep commands assume one test file in `$FILE`; translate `vi.` to `jest.` or `mock.` for other runners.

| # | Pattern | Symptom | Spot it | Fix |
|---|---------|---------|---------|-----|
| 1 | Whole-module mock | The module is replaced wholesale; the test checks the mock's behaviour | `grep -c 'vi\.mock(' "$FILE"`; three or more with no `importActual` is a red flag; a mock with no factory is worst | `spyOn` the one function, or a partial mock that spreads the real module |
| 2 | Empty stub payload | `'AA=='`, `Buffer.alloc(0)`, `''` stand in for real data; real parsing would fail | `grep -nE "AA==\|Buffer\.alloc\(0\)" "$FILE"` | A recorded fixture, or a builder that produces the smallest valid value |
| 3 | Call checked, body not | A mocked request asserts the URL was called, never what was sent | `grep -n 'toHaveBeenCalledWith' "$FILE"` finds no check on the body | Assert the body (`expect.objectContaining({ body: ... })`) or assert inside the handler |
| 4 | Type bypass | `as unknown as Config` lets fixtures miss required fields | `grep -nE 'as unknown as\|as any' "$FILE"` | `satisfies Config`, a factory, or parse through the schema |
| 5 | Snapshot only | Business logic asserted only by snapshot; a bug becomes "update snapshot" | snapshot count vs `toBe`/`toEqual`/`toThrow` count | Snapshots only for structural output; explicit assertions at least twice as many |
| 6 | Tautology | Expected value computed by the same logic as the code (or copied from it, e.g. `?? 'guest'` → expect `'guest'`) | Read the test next to the code: same formula? | Expected values from the rule's examples or worked out by hand |
| 7 | Mocking the unit under test | Spying on or stubbing the methods of the object being tested | `grep -A5 'describe.*Foo' "$FILE" \| grep 'spyOn.*Foo'` | Mock only its dependencies; needing to mock internals means extract a dependency |
| 8 | No assertion | `it('works', () => { run() })` always passes | test count vs `expect(` count | At least one assertion per test; enable the runner's expect-expect lint |
| 9 | Hardcoded-passable | Every test would pass if the function returned one constant | All happy-path cases share one expected output | Two or more input sets with different expected outputs |
| 10 | Happy only | No case exercises a refusal or error | No `toThrow`, no non-zero exit code, no error text asserted | Cases for every refusal the rule implies |
| 11 | Fallback blessing | Test asserts that `?? default` returns the default without asking whether the rule wants a refusal | A test whose expected value equals a fallback literal in the code | Check the rule; if it says refuse, assert the refusal |

Quick scan of one file:

```bash
FILE=src/foo.test.ts
echo "mocks:       $(grep -c 'vi\.mock(' "$FILE") (importActual: $(grep -c 'importActual' "$FILE"))"
echo "stub data:   $(grep -cE 'AA==|Buffer\.alloc\(0\)' "$FILE")"
echo "type bypass: $(grep -cE 'as unknown as|as any' "$FILE")"
echo "snapshots:   $(grep -cE 'toMatch(Inline)?Snapshot' "$FILE") vs explicit $(grep -cE 'toEqual|toBe|toThrow' "$FILE")"
echo "tests:       $(grep -cE '\b(it|test)\(' "$FILE") vs expects $(grep -c 'expect(' "$FILE")"
```

Counts are a prompt to read, not a verdict: a file with several `expect` calls in one test can still hide a test with none.
