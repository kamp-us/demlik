import type { ReferenceResult } from "../extract/references.js";
import type { ExportWidth, FunctionNode, PackageWidth } from "../schema.js";

export function packageOf(file: string, packageDirs: readonly string[]): string {
  let best = "";
  for (const dir of packageDirs) {
    if (dir === "") continue;
    if (file === dir || file.startsWith(`${dir}/`)) {
      if (dir.length > best.length) best = dir;
    }
  }
  return best;
}

function externalConsumersOf(
  name: string,
  ownFile: string,
  ownPackage: string,
  refs: ReferenceResult,
  packageDirs: readonly string[],
): string[] {
  const files = refs.identifierFiles.get(name) ?? [];
  const out: string[] = [];
  for (const f of files) {
    if (f === ownFile) continue;
    if (packageOf(f, packageDirs) === ownPackage) continue;
    out.push(f);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

export function findInterfaceWidth(
  functions: readonly FunctionNode[],
  refs: ReferenceResult,
  packageDirs: readonly string[],
): PackageWidth[] {
  const byPackage = new Map<string, ExportWidth[]>();

  for (const fn of functions) {
    if (!fn.isExported || fn.isTest) continue;
    const pkg = packageOf(fn.file, packageDirs);
    const externalConsumers = externalConsumersOf(fn.name, fn.file, pkg, refs, packageDirs);
    const row: ExportWidth = {
      id: fn.id,
      name: fn.name,
      file: fn.file,
      startLine: fn.startLine,
      externalConsumers,
    };
    const bucket = byPackage.get(pkg);
    if (bucket === undefined) byPackage.set(pkg, [row]);
    else bucket.push(row);
  }

  const packages: PackageWidth[] = [];
  for (const [pkg, exports] of byPackage) {
    exports.sort((a, b) => a.id.localeCompare(b.id));
    packages.push({
      package: pkg,
      exportCount: exports.length,
      zeroConsumerCount: exports.filter((e) => e.externalConsumers.length === 0).length,
      exports,
    });
  }

  packages.sort((a, b) => b.exportCount - a.exportCount || a.package.localeCompare(b.package));
  return packages;
}
