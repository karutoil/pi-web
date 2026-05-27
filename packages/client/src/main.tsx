import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./styles.css";
import "@xterm/xterm/css/xterm.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
