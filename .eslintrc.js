module.exports = {
    "env": {
        "es2020": true,
        "node": true
    },
    "ignorePatterns": [
        "**/.*.js",
        "out/**/*",
        "node_modules/**/*",
        ".vscode/**/*",
        ".vscode-test/**/*"
    ],
    "extends": [
        "plugin:import/typescript"
    ],
    "parser": "@typescript-eslint/parser",
    "parserOptions": {
		"project": [ 
            './packages/**/tsconfig.json',
            './tsconfig.json'
        ]
	},
    "plugins": [
        "@typescript-eslint",
        "@typescript-eslint/tslint",
        "import"
    ],
    "rules": {
        "@typescript-eslint/no-unused-vars": "warn",
        "@typescript-eslint/consistent-type-assertions": "warn",
        "@typescript-eslint/consistent-type-definitions": "warn",
        "@typescript-eslint/dot-notation": "warn",
        "@typescript-eslint/indent": "warn",
        "@typescript-eslint/member-delimiter-style": [
            "warn",
            {
                "multiline": {
                    "delimiter": "semi",
                    "requireLast": true
                },
                "singleline": {
                    "delimiter": "semi",
                    "requireLast": false
                }
            }
        ],
        "@typescript-eslint/no-floating-promises": "warn",
        "@typescript-eslint/no-misused-new": "warn",
        "@typescript-eslint/no-this-alias": "warn",
        "@typescript-eslint/no-unused-expressions": "warn",
        "@typescript-eslint/prefer-for-of": "warn",
        "@typescript-eslint/prefer-namespace-keyword": "warn",
        "@typescript-eslint/prefer-readonly": "warn",
        "@typescript-eslint/quotes": [
            "warn",
            "single",
            {
                "avoidEscape": true
            }
        ],
        "@typescript-eslint/semi": [
            "warn",
            "always"
        ],
        "@typescript-eslint/triple-slash-reference": "warn",
        "arrow-parens": [
            "warn",
            "as-needed"
        ],
        "complexity": "warn",
        "constructor-super": "warn",
        "curly": "warn",
        "eqeqeq": [
            "off",
            "always"
        ],
        "id-match": "warn",
        "import/no-deprecated": "warn",
        "import/order": "warn",
        "no-debugger": "warn",
        "no-duplicate-case": "warn",
        "no-duplicate-imports": "warn",
        "no-useless-escape": "error",
        "no-empty": [
            "warn",
            {
                "allowEmptyCatch": true
            }
        ],
        "no-irregular-whitespace": "warn",
        "no-redeclare": "warn",
        "no-restricted-syntax": [
            "warn",
            "ForInStatement"
        ],
        "no-useless-concat": "error",
        "no-return-await": "warn",
        "no-sequences": "warn",
        "no-shadow-restricted-names": "error",
        "no-throw-literal": "off",
        "no-trailing-spaces": [
            "warn",
            {
                "ignoreComments": true
            }
        ],
        "no-undef-init": "warn",
        "no-unsafe-finally": "warn",
        "no-var": "warn",
        "prefer-arrow-callback": [
            "warn",
            {
                "allowNamedFunctions": true
            }
        ],
        "no-template-curly-in-string": "error",
        "prefer-const": "warn",
        "prefer-template": "warn",
        "radix": "warn",
        "spaced-comment": [
            "warn",
            "always",
            {
                "markers": [
                    "/"
                ]
            }
        ],
        "use-isnan": "warn",
        "valid-typeof": "warn",
        "no-duplicate-imports": "off",
        "import/no-duplicates": "warn",
        "@typescript-eslint/tslint/config": [
            "error",
            {
                "rules": {
                    "import-spacing": true,
                    "invalid-void": false,
                    "no-dynamic-delete": true,
                    "no-unnecessary-callback-wrapper": true,
                    "prefer-conditional-expression": true,
                    "prefer-method-signature": true
                }
            }
        ]
    }
};
