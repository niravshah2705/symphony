'use strict';

/**
 * Shared in-memory fakes for @google-cloud/storage and @google-cloud/firestore,
 * used across this directory's unit/integration tests. Not a general emulator —
 * just enough surface for gcs.js/store.js/service.js to exercise real query
 * construction (nesting, batching, collectionGroup scoping, signed-URL shape)
 * without hitting real GCP.
 */

function makeFakeStorage({ objects = {} } = {}) {
  const calls = { getSignedUrl: [], delete: [] };
  const buckets = new Map();
  function bucket(name) {
    if (!buckets.has(name)) {
      buckets.set(name, {
        name,
        file(path) {
          return {
            path,
            async getSignedUrl(opts) {
              calls.getSignedUrl.push({ path, opts });
              return [`https://fake-gcs.example.com/${name}/${path}?signed=1`];
            },
            async exists() {
              return [Boolean(objects[path])];
            },
            async getMetadata() {
              if (!objects[path]) throw new Error('not found');
              return [{ size: String(objects[path].size), contentType: objects[path].contentType }];
            },
            async delete() {
              calls.delete.push({ path });
              delete objects[path];
            },
            async download() {
              if (!objects[path]) throw new Error('not found');
              return [objects[path].buffer || Buffer.from('')];
            },
          };
        },
      });
    }
    return buckets.get(name);
  }
  return { storageFactory: () => ({ bucket }), calls, objects };
}

function makeFakeFirestore() {
  const docs = new Map();

  function docRef(path) {
    return {
      path,
      async set(data, opts = {}) {
        if (opts.merge) docs.set(path, { ...(docs.get(path) || {}), ...data });
        else docs.set(path, { ...data });
      },
      async get() {
        const data = docs.get(path);
        return { exists: data !== undefined, data: () => (data === undefined ? undefined : { ...data }) };
      },
      async delete() {
        docs.delete(path);
      },
      collection(name) {
        return collectionRef(`${path}/${name}`);
      },
    };
  }

  function collectionRef(path) {
    return {
      path,
      doc(id) {
        return docRef(`${path}/${id}`);
      },
      async get() {
        const prefix = `${path}/`;
        const out = [];
        for (const [docPath, data] of docs.entries()) {
          if (docPath.startsWith(prefix) && !docPath.slice(prefix.length).includes('/')) {
            out.push({ data: () => ({ ...data }), ref: docRef(docPath) });
          }
        }
        return { docs: out };
      },
    };
  }

  function cosine(a, b) {
    const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
    const magA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
    const magB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
    return magA && magB ? dot / (magA * magB) : 0;
  }

  // A VectorValue-like object (real store.js wraps embeddings via FieldValue.vector)
  // exposes toArray(); a plain test array does not — normalize either shape.
  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value.toArray === 'function') return value.toArray();
    return null;
  }

  function collectionGroupQuery(name, filters) {
    return {
      where(field, op, value) {
        return collectionGroupQuery(name, [...filters, { field, value }]);
      },
      findNearest({ vectorField, queryVector, limit }) {
        return {
          async get() {
            const matches = [];
            for (const [docPath, data] of docs.entries()) {
              const segments = docPath.split('/');
              if (segments[segments.length - 2] !== name) continue;
              if (!filters.every((f) => data[f.field] === f.value)) continue;
              const vector = asArray(data[vectorField]);
              if (!vector) continue;
              matches.push({ docPath, data, vector });
            }
            matches.sort((a, b) => cosine(b.vector, queryVector) - cosine(a.vector, queryVector));
            return { docs: matches.slice(0, limit).map((m) => ({ data: () => ({ ...m.data }) })) };
          },
        };
      },
    };
  }

  const db = {
    collection(name) {
      return collectionRef(name);
    },
    collectionGroup(name) {
      return collectionGroupQuery(name, []);
    },
    batch() {
      const ops = [];
      return {
        set(ref, data, opts) {
          ops.push(() => ref.set(data, opts));
        },
        delete(ref) {
          ops.push(() => ref.delete());
        },
        async commit() {
          for (const op of ops) await op();
        },
      };
    },
  };

  return { db, docs };
}

module.exports = { makeFakeStorage, makeFakeFirestore };
