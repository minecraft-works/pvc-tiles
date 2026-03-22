export default {
    extends: ['@commitlint/config-conventional'],
    rules: {
        // Types allowed per project conventions
        'type-enum': [2, 'always', [
            'feat',     // New feature (minor version bump)
            'fix',      // Bug fix (patch version bump)
            'docs',     // Documentation only
            'chore',    // Maintenance tasks
            'refactor', // Code refactoring
            'test',     // Adding or updating tests
            'ci',       // CI/CD changes
            'style',    // Formatting, missing semicolons, etc.
            'perf',     // Performance improvements
            'revert'    // Revert a previous commit
        ]],
        // Subject line limits
        'subject-max-length': [2, 'always', 100],
        'subject-empty': [2, 'never'],
        'type-empty': [2, 'never'],
        // Body and footer
        'body-max-line-length': [1, 'always', 200],
        'footer-max-line-length': [1, 'always', 200]
    }
};
