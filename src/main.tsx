import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installDevBridge } from "./lib/devbridge";
import { applyTheme, getThemePref } from "./lib/theme";
import { lang } from "./lib/i18n";
import { applySavedZoom } from "./lib/zoom";
import { api } from "./lib/api";
import "./styles/app.css";

installDevBridge();
applyTheme(getThemePref());
applySavedZoom();
document.documentElement.lang = lang();
api.setLocale(lang()).catch(() => {});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
