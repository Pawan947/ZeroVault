import nodePlugin from "eslint-plugin-node";

export default [
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "commonjs", // Assuming you're using CommonJS since it's a Node app mostly doing require()
            globals: {
                console: "readonly",
                process: "readonly",
                __dirname: "readonly",
                require: "readonly",
                module: "readonly",
                Buffer: "readonly",
                setTimeout: "readonly"
            },
        },
        plugins: {
            node: nodePlugin,
        },
        rules: {
            "no-unused-vars": "warn",
            "no-undef": "error",
            "semi": ["warn", "always"],
            "quotes": ["warn", "double", { "avoidEscape": true }]
        },
        ignores: [
            "node_modules/**",
            "public/cryptoWorker.js"
        ],
    },
];
