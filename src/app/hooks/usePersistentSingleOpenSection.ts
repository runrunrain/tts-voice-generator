import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_PREFIX = "tts-voice-generator.settingsAccordion.v1";

type UsePersistentSingleOpenSectionOptions = {
  storageKey: string;
  sectionIds: readonly string[];
  defaultSectionId?: string;
};

function storageAvailable(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function namespacedKey(storageKey: string) {
  return `${STORAGE_PREFIX}.${storageKey}`;
}

function resolveOpenSectionId(storageKey: string, sectionIds: readonly string[], defaultSectionId?: string): string | null {
  if (sectionIds.length === 0) return null;

  const fallback = defaultSectionId && sectionIds.includes(defaultSectionId)
    ? defaultSectionId
    : sectionIds[0];

  const storage = storageAvailable();
  if (!storage) return fallback;

  try {
    const storedSectionId = storage.getItem(namespacedKey(storageKey));
    return storedSectionId && sectionIds.includes(storedSectionId) ? storedSectionId : fallback;
  } catch {
    return fallback;
  }
}

function persistOpenSectionId(storageKey: string, sectionId: string) {
  const storage = storageAvailable();
  if (!storage) return;

  try {
    storage.setItem(namespacedKey(storageKey), sectionId);
  } catch {
    // Storage can be unavailable in private browsing, SSR, or tests. The in-memory
    // accordion state remains functional, so persistence failure is intentionally non-fatal.
  }
}

export function usePersistentSingleOpenSection({
  storageKey,
  sectionIds,
  defaultSectionId,
}: UsePersistentSingleOpenSectionOptions) {
  const sectionSignature = sectionIds.join("\u001F");
  const validSectionIds = useMemo(() => new Set(sectionIds), [sectionSignature]);

  const [openSectionId, setOpenSectionId] = useState<string | null>(() => (
    resolveOpenSectionId(storageKey, sectionIds, defaultSectionId)
  ));

  useEffect(() => {
    setOpenSectionId(resolveOpenSectionId(storageKey, sectionIds, defaultSectionId));
  }, [defaultSectionId, sectionSignature, storageKey]);

  useEffect(() => {
    if (openSectionId && validSectionIds.has(openSectionId)) {
      persistOpenSectionId(storageKey, openSectionId);
    }
  }, [openSectionId, storageKey, validSectionIds]);

  const setSectionOpen = useCallback((sectionId: string, isOpen: boolean) => {
    if (!validSectionIds.has(sectionId)) return;

    setOpenSectionId((currentSectionId) => {
      if (isOpen) return sectionId;
      return currentSectionId === sectionId ? null : currentSectionId;
    });
  }, [validSectionIds]);

  const isSectionOpen = useCallback((sectionId: string) => openSectionId === sectionId, [openSectionId]);

  return {
    openSectionId,
    isSectionOpen,
    setSectionOpen,
  };
}
