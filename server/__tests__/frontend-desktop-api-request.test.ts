import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../../src/app/services/httpAdapter";

const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as { window?: unknown }).window;

function installFetchMock() {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("frontend desktop apiRequest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it("merges Electron desktop token headers for same-origin API paths", async () => {
    const fetchMock = installFetchMock();
    (globalThis as { window?: unknown }).window = {
      ttsDesktop: {
        getApiHeaders: async () => ({ "X-TTS-Desktop-Token": "desktop-token" }),
      },
    };

    await apiRequest("/api/settings", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-TTS-Desktop-Token": "stale-token",
        "X-Custom-Header": "preserved",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/settings", expect.objectContaining({ method: "PUT" }));
    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Custom-Header")).toBe("preserved");
    expect(headers.get("X-TTS-Desktop-Token")).toBe("desktop-token");
  });

  it("keeps browser/dev behavior when no desktop token provider exists", async () => {
    const fetchMock = installFetchMock();
    Reflect.deleteProperty(globalThis, "window");

    await apiRequest("/api/settings", {
      headers: { "Content-Type": "application/json" },
    });

    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.has("X-TTS-Desktop-Token")).toBe(false);
  });

  it("does not attach the desktop token to non-API resources", async () => {
    const fetchMock = installFetchMock();
    (globalThis as { window?: unknown }).window = {
      ttsDesktop: {
        getApiHeaders: async () => ({ "X-TTS-Desktop-Token": "desktop-token" }),
      },
    };

    await apiRequest("/assets/logo.svg");

    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.has("X-TTS-Desktop-Token")).toBe(false);
  });
});
