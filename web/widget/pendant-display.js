import { buildDisplayFrame, CoordinateSystem, JogMode } from '../whb04b-webhid.js';

// CNCjs preserves GRBL status-report units ($13), independently of G20/G21.
export function controllerDisplayFrame(state, { coordinates = 'work', jogMode = JogMode.None, reportUnits } = {}) {
  const displayUnits = state?.parserstate?.modal?.units;
  if (![0, 1, '0', '1'].includes(reportUnits) || !['G20', 'G21'].includes(displayUnits)) return null;
  const scale = (Number(reportUnits) === 1 ? 25.4 : 1) / (displayUnits === 'G20' ? 25.4 : 1);
  const status = state?.status;
  const position = coordinates === 'machine' ? status?.mpos : status?.wpos;
  const values = [position?.x, position?.y, position?.z, status?.ov?.[0], status?.ov?.[2]];
  if (values.some(value => value === undefined || value === null || value === '')) return null;
  const [x, y, z, feedRate, spindleRate] = values.map(Number);
  return buildDisplayFrame({
    jogMode, coordinateSystem: coordinates === 'work' ? CoordinateSystem.X1Y1Z1 : CoordinateSystem.XYZ,
    x: x * scale, y: y * scale, z: z * scale, feedRate, spindleRate,
  });
}
