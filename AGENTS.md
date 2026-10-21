<!-- dev-tooling:start -->

## Development tooling

Run these mise tasks from the repository root. Existing project instructions and prerequisite tasks still apply.
Review formatting and safe-fix diffs; do not rewrite unrelated files or change tool versions as part of a routine check.

- Before finishing changes across stacks, run all configured lint, formatting, and type checks. Use `mise run check`.
- To format every selected language, run the aggregate formatter and review the diff. Use `mise run format`.
- After cross-stack behavior changes, run all configured test suites and their prerequisites. Use `mise run test`.
- When project dependencies changed or are missing, sync dependencies for selected projects. Use `mise run deps`.

### JavaScript / TypeScript

- When JavaScript dependencies change or are missing, install the package dependencies. Use `mise run deps:javascript`.
- After JavaScript or TypeScript edits, check lint, formatting, and import organization with Biome. Use `mise run check:javascript`.
- When formatting or safe lint fixes need correction, run Biome check with write enabled; this also organizes imports. Use `mise run format:javascript`.
- After behavior changes, run the package or existing project tests and their prerequisites. Use `mise run test:javascript`.

### Markdown

- After Markdown edits, run Markdownlint and Prettier checks. Use `mise run check:markdown`.
- When Markdown formatting needs correction, run Prettier scoped to Markdown, not JavaScript or TypeScript. Use `mise run format:markdown`.

### Shell

- After shell script edits, check the selected files with ShellCheck. Use `mise run check:shell`.

Tool versions, variables, and tasks in higher-precedence mise files override the generated fragment. Check `mise config` and `mise tasks ls` when behavior differs.
Run installation or dependency-sync commands only when needed; they can download packages or execute dependency build scripts.
<!-- dev-tooling:end -->
