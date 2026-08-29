import "./public-asset-with-sidecar.css";

const globals = globalThis as { [key: symbol]: unknown };
globals[Symbol.for("webapp.publicAssetSidecarMarker")] = "webapp-public-asset-sidecar";
