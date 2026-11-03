"use strict";

(() => {
  const DATABASE_NAME = "ope-code-vault-data";
  const DATABASE_VERSION = 1;
  const STORE_NAME = "records";
  const CURRENT_KEY = "lesson-library";
  const SNAPSHOT_PREFIX = "snapshot:";
  const MAX_SNAPSHOTS = 10;
  let databasePromise;
  let storageMode = "indexeddb";

  function openDatabase() {
    if (!("indexedDB" in window)) {
      storageMode = "localstorage";
      return Promise.resolve(null);
    }
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(STORE_NAME)) {
            database.createObjectStore(STORE_NAME, { keyPath: "key" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Could not open browser lesson storage."));
        request.onblocked = () => reject(new Error("Lesson storage is blocked by another open app tab. Close other tabs and retry."));
      }).catch((error) => {
        databasePromise = null;
        throw error;
      });
    }
    return databasePromise;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Browser storage request failed."));
    });
  }

  async function load() {
    const database = await openDatabase();
    if (!database) {
      try {
        const text = localStorage.getItem("java-vault-library-v1");
        return text ? JSON.parse(text) : null;
      } catch (error) {
        throw new Error(`Local browser storage could not be read: ${error.message}`);
      }
    }
    const transaction = database.transaction(STORE_NAME, "readonly");
    const record = await requestResult(transaction.objectStore(STORE_NAME).get(CURRENT_KEY));
    return record ? record.value : null;
  }

  async function save(value) {
    const database = await openDatabase();
    if (!database) {
      try {
        localStorage.setItem("java-vault-library-v1", JSON.stringify(value));
        return;
      } catch (error) {
        throw new Error(`Browser storage could not save your lessons: ${error.message}`);
      }
    }

    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const currentRequest = store.get(CURRENT_KEY);
      currentRequest.onsuccess = () => {
        const previous = currentRequest.result;
        const timestamp = new Date().toISOString();
        const snapshotValue = previous && previous.value ? previous.value : value;
        const snapshotId = window.crypto && typeof window.crypto.randomUUID === "function"
          ? window.crypto.randomUUID()
          : Math.random().toString(36).slice(2, 12);
        store.put({
          key: `${SNAPSHOT_PREFIX}${Date.now()}-${snapshotId}`,
          value: snapshotValue,
          savedAt: timestamp
        });
        store.put({ key: CURRENT_KEY, value, savedAt: new Date().toISOString() });

        const snapshotsRequest = store.getAll();
        snapshotsRequest.onsuccess = () => {
          const snapshots = snapshotsRequest.result
            .filter((record) => record.key.startsWith(SNAPSHOT_PREFIX))
            .sort((left, right) => right.savedAt.localeCompare(left.savedAt));
          snapshots.slice(MAX_SNAPSHOTS).forEach((record) => store.delete(record.key));
        };
      };
      currentRequest.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Saving lesson data failed."));
      transaction.onabort = () => reject(transaction.error || new Error("Saving lesson data was cancelled."));
    });
  }

  async function snapshots() {
    const database = await openDatabase();
    if (!database) return [];
    const transaction = database.transaction(STORE_NAME, "readonly");
    const records = await requestResult(transaction.objectStore(STORE_NAME).getAll());
    return records
      .filter((record) => record.key.startsWith(SNAPSHOT_PREFIX) && record.value)
      .sort((left, right) => right.savedAt.localeCompare(left.savedAt));
  }

  async function requestPersistentStorage() {
    if (!navigator.storage || typeof navigator.storage.persist !== "function") return false;
    return navigator.storage.persist();
  }

  async function estimate() {
    if (!navigator.storage || typeof navigator.storage.estimate !== "function") return null;
    const result = await navigator.storage.estimate();
    return {
      usage: Number.isFinite(result.usage) ? result.usage : 0,
      quota: Number.isFinite(result.quota) ? result.quota : 0
    };
  }

  window.VaultStorage = Object.freeze({
    load,
    save,
    snapshots,
    requestPersistentStorage,
    estimate,
    get mode() {
      return storageMode;
    }
  });
})();
