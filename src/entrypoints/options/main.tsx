import { render } from "preact";
import { Options } from "./Options";
import "./options.css";

const root = document.getElementById("app");
if (root) render(<Options />, root);
