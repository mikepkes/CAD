# Paper folding tests (experimental)

Paper folding (the crane, masu, paper airplane and pop-ups) is experimental, so
its tests live here and stay out of `npm test` and CI. Run them with:

```bash
npm run test:origami
```

That runs every test in this folder: the folding geometry (`sheetSequence`,
`sheetLayers`, `sheetBend`, `sheetEdit`, `creasePattern`), each paper model's
build checks (`*.build.test.ts`), the Folds panel (`ui/`), and the paper
examples through the usual example checks (`examples.test.ts`; the list is
`PAPER` in `test/exampleSuite.ts`).

Known gaps are listed in `src/core/sheetSequence.ts`.
