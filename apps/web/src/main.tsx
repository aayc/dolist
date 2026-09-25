import "./styles/theme.css";
import "./styles/base.css";
import "@ddl/editor/styles.css";
import "./styles/layout.css";
import "./styles/explorer.css";
import "./styles/tabs.css";
import "./styles/statusbar.css";
import "./styles/overlays.css";
import "./styles/drawings.css";
import { startApp } from "./app/bootstrap";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
void startApp(root);
