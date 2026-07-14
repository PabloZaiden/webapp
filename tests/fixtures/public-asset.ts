import { publicAssetMarker } from "./public-asset-helper";

const globals = globalThis as { [key: symbol]: unknown };
globals[Symbol.for("webapp.publicAssetMarker")] = publicAssetMarker;
