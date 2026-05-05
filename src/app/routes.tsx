import { createBrowserRouter } from "react-router";
import { Shell } from "./components/Shell";
import { GeneratePage } from "./pages/GeneratePage";
import { DirectorPage } from "./pages/DirectorPage";
import { VoicesPage } from "./pages/VoicesPage";
import { HistoryPage } from "./pages/HistoryPage";
import { HistoryDetailPage } from "./pages/HistoryDetailPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TasksPage } from "./pages/TasksPage";
import { TaskWorkspacePage } from "./pages/TaskWorkspacePage";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: Shell,
    children: [
      { index: true, Component: GeneratePage },
      { path: "generate", Component: GeneratePage },
      { path: "generate/director", Component: DirectorPage },
      { path: "voices", Component: VoicesPage },
      { path: "history", Component: HistoryPage },
      { path: "history/:jobId", Component: HistoryDetailPage },
      { path: "tasks", Component: TasksPage },
      { path: "tasks/:taskId", Component: TaskWorkspacePage },
      { path: "settings", Component: SettingsPage },
    ],
  },
]);
