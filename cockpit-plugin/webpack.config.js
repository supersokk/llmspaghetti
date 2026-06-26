const path = require("path");

module.exports = {
  entry: "./src/llmspaghetti.jsx",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "llmspaghetti.js",
  },
  mode: "production",
  module: {
    rules: [
      {
        test: /\.(js|jsx)$/,
        exclude: /node_modules/,
        use: {
          loader: "babel-loader",
          options: {
            presets: [
              ["@babel/preset-env", { targets: "defaults" }],
              ["@babel/preset-react", { runtime: "automatic" }],
            ],
          },
        },
      },
    ],
  },
  resolve: {
    extensions: [".js", ".jsx"],
    modules: ["node_modules", "src"],
  },
  // Cockpit provides React globally — don't bundle it
  externals: {
    cockpit: "cockpit",
  },
};
