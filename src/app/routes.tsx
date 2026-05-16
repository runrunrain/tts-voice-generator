import { createBrowserRouter } from "react-router";
import { Shell } from "./components/Shell";
import { DirectorPage } from "./pages/DirectorPage";
import { VoicesPage } from "./pages/VoicesPage";
import { HistoryPage } from "./pages/HistoryPage";
import { HistoryDetailPage } from "./pages/HistoryDetailPage";
import { SettingsPage } from "./pages/SettingsPage";
import { OpenCodeSettingsPage } from "./pages/settings/OpenCodeSettingsPage";
import { TasksPage } from "./pages/TasksPage";
import { TaskWorkspacePage } from "./pages/TaskWorkspacePage";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: Shell,
    children: [
      { index: true, Component: DirectorPage },
      { path: "generate", Component: DirectorPage },
      { path: "generate/director", Component: DirectorPage },
      { path: "voices", Component: VoicesPage },
      { path: "history", Component: HistoryPage },
      { path: "history/:jobId", Component: HistoryDetailPage },
      { path: "tasks", Component: TasksPage },
      { path: "tasks/:taskId", Component: TaskWorkspacePage },
      { path: "settings", Component: SettingsPage },
      { path: "settings/api-key", Component: SettingsPage },
      { path: "settings/defaults", Component: SettingsPage },
      { path: "settings/limits", Component: SettingsPage },
      { path: "settings/plugin-token", Component: SettingsPage },
      { path: "settings/agent", Component: SettingsPage },
      { path: "settings/updates", Component: SettingsPage },
      { path: "settings/diagnostics", Component: SettingsPage },
      { path: "settings/opencode", Component: OpenCodeSettingsPage },
    ],
  },
]);
