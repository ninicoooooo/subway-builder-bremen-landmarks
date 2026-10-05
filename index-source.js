import * as THREE from "three";
import DATA from "./landmark-data.js";

(() => {
  const api = window.SubwayBuilderAPI;
  const LAYER_ID = "bremen-lod2-landmarks";
  const MODEL_ORIGIN = [8.80, 53.08];
  const EARTH_CIRCUMFERENCE = 40075016.68557849;
  const originLatRad = MODEL_ORIGIN[1] * Math.PI / 180;
  const mercatorScale = 1 / (EARTH_CIRCUMFERENCE * Math.cos(originLatRad));

  if (!api?.map?.registerLayer || !api?.hooks?.onMapReady) return;

  const mercatorX = (lon) => (lon + 180) / 360;
  const mercatorY = (lat) => {
    const radians = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(Math.PI / 4 + radians / 2)) / Math.PI) / 2;
  };
  const toLocal = ([lon, lat, z]) => new THREE.Vector3(
    (mercatorX(lon) - mercatorX(MODEL_ORIGIN[0])) / mercatorScale,
    (mercatorY(lat) - mercatorY(MODEL_ORIGIN[1])) / mercatorScale,
    z
  );

  function openRing(ring) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    return first[0] === last[0] && first[1] === last[1] && first[2] === last[2]
      ? ring.slice(0, -1)
      : ring;
  }

  function projection(points) {
    const normal = new THREE.Vector3();
    for (let index = 0; index < points.length; index += 1) {
      const a = points[index];
      const b = points[(index + 1) % points.length];
      normal.x += (a.y - b.y) * (a.z + b.z);
      normal.y += (a.z - b.z) * (a.x + b.x);
      normal.z += (a.x - b.x) * (a.y + b.y);
    }
    const [x, y, z] = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)];
    if (x >= y && x >= z) return (point) => new THREE.Vector2(point.y, point.z);
    if (y >= z) return (point) => new THREE.Vector2(point.x, point.z);
    return (point) => new THREE.Vector2(point.x, point.y);
  }

  async function createGeometry() {
    const buildingBase = new Map();
    for (const [, ring, buildingId] of DATA.features) {
      const minimum = Math.min(...ring.map((point) => point[2]));
      buildingBase.set(buildingId, Math.min(buildingBase.get(buildingId) ?? Infinity, minimum));
    }
    const positions = {};
    for (let featureIndex = 0; featureIndex < DATA.features.length; featureIndex += 1) {
      const [kind, ring, buildingId] = DATA.features[featureIndex];
      const name = DATA.names[buildingId] || "";
      const palette = /(Weser Tower|Landmark|Lofthaus|Zechhaus|Weserstadion|ÖVB|Bürgerschaft|City Gate|Karstadt|GALERIA|Universum|Waterfront|Aalto|MOBI|TQ Studios|Kühne|Volksbank|Forum am Domshof|Domshof Passage|McDonald)/i.test(name)
        ? "modern"
        : /(Speicher|Postamt|Überseemuseum|Amtsgericht|Tabak|Heizwerk|Atelierhäuser|Getreide|Beck’s|Rolandmühle|Umgedrehte Kommode)/i.test(name) ? "brick" : "historic";
      const bucket = `${palette}-${kind}`;
      positions[bucket] ||= [];
      const base = buildingBase.get(buildingId);
      const points = openRing(ring).map(([lon, lat, z]) => toLocal([lon, lat, z - base]));
      if (points.length >= 3) {
        const project = projection(points);
        for (const triangle of THREE.ShapeUtils.triangulateShape(points.map(project), [])) {
          for (const index of triangle) {
            const point = points[index];
            positions[bucket].push(point.x, point.y, point.z);
          }
        }
      }
      if (featureIndex > 0 && featureIndex % 600 === 0) {
        await new Promise(requestAnimationFrame);
      }
    }
    return Object.fromEntries(Object.entries(positions).map(([kind, values]) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(values, 3));
      // The geometry intentionally stays non-indexed: every CityGML surface
      // keeps a flat normal instead of producing blurred gradients over edges.
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      return [kind, geometry];
    }));
  }

  function nativeBuildingLayers(map) {
    return (map.getStyle()?.layers || []).filter((styleLayer) => {
      const identity = `${styleLayer.id} ${styleLayer["source-layer"] || ""}`;
      return styleLayer.type === "fill-extrusion"
        && /building/i.test(identity)
        && !/(foundation|depth|fundament|tiefe)/i.test(identity);
    });
  }

  function hideReplacedLod1(map) {
    const exclusion = ["!", ["in", ["get", "id"], ["literal", DATA.lod1Ids]]];
    const changed = [];
    for (const styleLayer of nativeBuildingLayers(map)) {
      const original = map.getFilter(styleLayer.id) || null;
      try {
        map.setFilter(styleLayer.id, original ? ["all", original, exclusion] : exclusion);
        changed.push({ id: styleLayer.id, filter: original });
      } catch (error) {
        console.warn(`[Bremen LoD2] LoD1-Filter für ${styleLayer.id} konnte nicht gesetzt werden`, error);
      }
    }
    console.info(`[Bremen LoD2] ${DATA.lod1Ids.length} LoD1-Grundrisse in ${changed.length} Kartenebene(n) ersetzt`);
    return changed;
  }

  const layer = {
    id: LAYER_ID,
    type: "custom",
    renderingMode: "3d",

    onAdd(map, gl) {
      this.removed = false;
      this.map = map;
      this.camera = new THREE.Camera();
      this.scene = new THREE.Scene();
      this.materials = {
        "historic-wall": new THREE.MeshStandardMaterial({ color: 0xc7c3ba, roughness: 1, metalness: 0, side: THREE.DoubleSide, flatShading: true }),
        "historic-roof": new THREE.MeshStandardMaterial({ color: 0x80645d, roughness: 1, metalness: 0, side: THREE.DoubleSide, flatShading: true }),
        "modern-wall": new THREE.MeshStandardMaterial({ color: 0xbfc4c5, roughness: 0.96, metalness: 0, side: THREE.DoubleSide, flatShading: true }),
        "modern-roof": new THREE.MeshStandardMaterial({ color: 0x747779, roughness: 1, metalness: 0, side: THREE.DoubleSide, flatShading: true }),
        "brick-wall": new THREE.MeshStandardMaterial({ color: 0xb69e8d, roughness: 1, metalness: 0, side: THREE.DoubleSide, flatShading: true }),
        "brick-roof": new THREE.MeshStandardMaterial({ color: 0x75605b, roughness: 1, metalness: 0, side: THREE.DoubleSide, flatShading: true }),
      };
      this.scene.add(new THREE.HemisphereLight(0xffffff, 0x73777a, 2.35));
      const sun = new THREE.DirectionalLight(0xffffff, 2.25);
      sun.position.set(-80, -120, 180);
      this.scene.add(sun);
      this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      this.renderer.autoClear = false;
      createGeometry().then((geometries) => {
        if (this.removed) {
          Object.values(geometries).forEach((geometry) => geometry.dispose());
          return;
        }
        this.geometries = geometries;
        this.meshes = Object.entries(geometries).map(([bucket, geometry]) => new THREE.Mesh(geometry, this.materials[bucket]));
        this.scene.add(...this.meshes);
        this.map.triggerRepaint();
        console.info(`[Bremen LoD2] ${DATA.landmarks} Wahrzeichen, ${DATA.buildings} Gebäudeteile und ${DATA.surfaces} Flächen geladen`);
      }).catch((error) => console.error("[Bremen LoD2] Wahrzeichen konnten nicht aufgebaut werden", error));
    },

    render(gl, matrix) {
      const model = new THREE.Matrix4()
        .makeTranslation(mercatorX(MODEL_ORIGIN[0]), mercatorY(MODEL_ORIGIN[1]), 0)
        .scale(new THREE.Vector3(mercatorScale, mercatorScale, mercatorScale));
      this.camera.projectionMatrix.fromArray(matrix).multiply(model);
      this.renderer.resetState();
      this.renderer.render(this.scene, this.camera);
    },

    onRemove() {
      this.removed = true;
      Object.values(this.geometries || {}).forEach((geometry) => geometry.dispose());
      Object.values(this.materials || {}).forEach((material) => material.dispose());
      this.renderer?.dispose();
    },
  };

  // Railyard owns city registration, tile URLs and gameplay data.
  // Roads are merged into its general-tiles source; no extra tile server.
  let currentCity = null;
  let mapRef = null;
  const watchedMaps = new WeakSet();
  let updating = false;
  const roadLayers = [
    { id: "bremen-roads-highway", roadClass: "highway", color: "#c9c5bd", widths: [8, 1.5, 12, 3, 15, 7] },
    { id: "bremen-roads-major", roadClass: "major", color: "#d8d4cd", widths: [9, 1, 12, 2, 15, 5] },
    { id: "bremen-roads-minor", roadClass: "minor", color: "#e2dfd9", widths: [10, 0.5, 12, 1, 15, 3] },
  ];

  function hasBremenTiles(map) {
    const tiles = map.getStyle()?.sources?.["general-tiles"]?.tiles;
    // Tile URLs are authoritative while the city-load event and style reload overlap.
    if (tiles?.length) return tiles.some((url) => /\/BREM\//.test(url));
    return currentCity === "BREM";
  }

  function updateBremenLayers() {
    const map = mapRef;
    if (!map || updating || !map.isStyleLoaded()) return;
    updating = true;
    try {
      if (!hasBremenTiles(map)) {
        for (const id of [LAYER_ID, ...roadLayers.map((item) => item.id)]) {
          if (map.getLayer(id)) map.removeLayer(id);
        }
        return;
      }
      if (!map.getSource("general-tiles")) return;
      const before = map.getLayer("neighborhood-labels") ? "neighborhood-labels" : undefined;
      for (const item of roadLayers) {
        if (!map.getLayer(item.id)) map.addLayer({
          id: item.id, type: "line", source: "general-tiles", "source-layer": "roads",
          filter: ["==", ["get", "roadClass"], item.roadClass],
          paint: { "line-color": item.color, "line-width": ["interpolate", ["linear"], ["zoom"], ...item.widths] },
        }, before);
      }
      if (!map.getLayer(LAYER_ID)) {
        // MapLibre attaches state to custom layers. Use a fresh object after each reload.
        map.addLayer({ ...layer }, before);
        hideReplacedLod1(map);
      }
    } finally {
      updating = false;
    }
  }

    api.map.setLayerOverride({
        layerId: "water",
        sourceLayer: "water"
    });

    api.map.setLayerOverride({
        layerId: "parks-large",
        sourceLayer: "landuse",
        filter: ["==", ["get", "kind"], "park"]
    });

    api.map.setLayerOverride({
        layerId: "parks-small",
        sourceLayer: "landuse",
        filter: ["==", ["get", "kind"], "park"]
    });

    api.map.setLayerOverride({
        layerId: "commercial",
        sourceLayer: "landuse",
        filter: [
            "in",
            ["get", "kind"],
            ["literal", ["commercial", "university"]]
        ]
    });

    api.map.setLayerOverride({
        layerId: "airports",
        sourceLayer: "landuse",
        filter: ["==", ["get", "kind"], "aerodrome"]
    });


  api.map.setDefaultLayerVisibility("BREM", { buildingFoundations: false, oceanFoundations: false });
  api.hooks.onCityLoad((code) => {
    currentCity = code;
    updateBremenLayers();
  });
  api.hooks.onMapReady((map) => {
    mapRef = map || api.utils.getMap();
    if (!watchedMaps.has(mapRef)) {
      watchedMaps.add(mapRef);
      mapRef.on("styledata", updateBremenLayers);
      mapRef.on("idle", updateBremenLayers);
    }
    updateBremenLayers();
  });
  console.info("[Bremen Railyard 1.1.5] Begleitmod geladen; Kartenserver wird von Railyard verwaltet");
})();
