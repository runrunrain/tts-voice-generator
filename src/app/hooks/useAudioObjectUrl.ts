import { useEffect, useState } from "react";
import { createAudioObjectUrl } from "../services/audioAsset";

export function useAudioObjectUrl(audioUrl: string | null | undefined) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    let revoke: (() => void) | null = null;

    setObjectUrl(null);
    setError(null);
    if (!audioUrl) {
      setLoading(false);
      return () => undefined;
    }

    setLoading(true);
    createAudioObjectUrl(audioUrl)
      .then((asset) => {
        if (!active) {
          asset.revoke();
          return;
        }
        revoke = asset.revoke;
        setObjectUrl(asset.objectUrl);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "音频加载失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      revoke?.();
    };
  }, [audioUrl]);

  return { objectUrl, loading, error };
}
