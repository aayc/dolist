import { CenterPane } from "../features/layout/CenterPane";
import { ConnectionBanner } from "../features/layout/ConnectionBanner";
import { LeftSidebar } from "../features/layout/LeftSidebar";
import { Ribbon } from "../features/layout/Ribbon";
import { RightSidebar } from "../features/layout/RightSidebar";
import { StatusBar } from "../features/layout/StatusBar";
import { Overlays } from "../features/overlays/Overlays";
import { Toaster } from "../features/toasts/Toaster";

export function App() {
  return (
    <div className="app" data-testid="app">
      <ConnectionBanner />
      <div className="app-main">
        <Ribbon />
        <LeftSidebar />
        <CenterPane />
        <RightSidebar />
      </div>
      <StatusBar />
      <Overlays />
      <Toaster />
    </div>
  );
}
