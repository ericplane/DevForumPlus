import { render } from "preact";
import { Popup } from "./Popup";
import "./popup.css";

const root = document.getElementById("app");
if (root) render(<Popup />, root);
