import { buildDisplayFrame, CoordinateSystem, JogMode } from '../whb04b-webhid.js';

// CNCjs positions are already expressed in its reported controller units.
// The pendant has no unit flag: preserve those values without conversion.
export function controllerDisplayFrame(state, { coordinates = 'work', jogMode = JogMode.None } = {}) {
  const status = state?.status;
  const position = coordinates === 'machine' ? status?.mpos : status?.wpos;
  const values = [position?.x, position?.y, position?.z, status?.ov?.[0], status?.ov?.[2]];
  if (values.some(value => value === undefined || value === null || value === '')) return null;
  const [x, y, z, feedRate, spindleRate] = values.map(Number);
  return buildDisplayFrame({
    jogMode, coordinateSystem: coordinates === 'work' ? CoordinateSystem.X1Y1Z1 : CoordinateSystem.XYZ,
    x, y, z, feedRate, spindleRate,
  });
}
