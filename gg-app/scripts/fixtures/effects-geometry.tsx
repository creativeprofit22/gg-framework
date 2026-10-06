import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/App.css";
import { ActionMetal } from "../../src/ActionMetal";
import { MetalButton } from "../../src/MetalButton";
import { GgUiButton } from "../../src/GgUiButton";

function Fixture() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 200);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="app window-focused" style={{ padding: 40 }}>
      <GgUiButton />
      <MetalButton className="btn btn-primary" windowFocused>
        + New
      </MetalButton>
      <div className="inputwrap" style={{ width: 300, height: 140, marginTop: 40 }}>
        <div className={`enhance-pill-host${visible ? " visible" : ""}`}>
          <ActionMetal active={visible} windowFocused variant="button" />
          <button className="enhance-pill">Enhance?</button>
        </div>
        <div className="inputactions-trailing">
          <ActionMetal active windowFocused />
          <button className="icon-circle icon-circle-primary">↑</button>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
