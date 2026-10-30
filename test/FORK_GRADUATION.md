# Fork graduation seed compatibility

The fork's immutable migrations v147 and v152 seed
`facts.default_visibility=world`. Engine graduation accepts this exact row as
native schema state when deciding whether a target is empty. Other values for
the same key, unrelated configuration keys, and existing target rows still
refuse graduation before copying or fencing the target. The source remains
writable on refusal.

`graduation-world-only-seed.test.ts` exercises native plan/run with real PGLite
engines and the production target-emptiness probe. It covers successful custody
transfer plus private, uppercase, whitespace, custom-setting and foreign-table
refusals. Existing graduation state/crash/rollback assertions remain unchanged.
