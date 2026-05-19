# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [Unreleased]

### Added

- Initial project scaffolding: `package.json`, `CLAUDE.md`, `.gitignore`, `CHANGELOG.md`.
- `pg-boss ^12.18.2` declared as a peer dependency.
- TypeScript with `strict` mode and `noUncheckedIndexedAccess`, ESM output via `"type": "module"` and `NodeNext` resolution, `.d.ts` declarations emitted alongside `.js`.
- `npm run build` script (runs `tsc`); source in `src/`, build output in `dist/`.
- Placeholder `src/index.ts` so the build pipeline is exercisable end-to-end.
- ESLint flat config (`eslint.config.js`) with `typescript-eslint` `recommended-type-checked` + `stylistic-type-checked` presets, using `projectService` for tsconfig auto-discovery.
- `npm run lint` and `npm run lint:fix` scripts.
