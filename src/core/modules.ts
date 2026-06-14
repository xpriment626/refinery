export const refineryModuleDescriptorSchemaVersion = "refinery.module.v1";

export const refineryModuleKinds = ["runtime", "adapter", "sink", "workbench"] as const;

export type RefineryModuleKind = (typeof refineryModuleKinds)[number];

export interface RefineryModuleDescriptor {
  schemaVersion: typeof refineryModuleDescriptorSchemaVersion;
  kind: RefineryModuleKind;
  name: string;
  version: string;
  entrypoint: string;
  capabilities: string[];
}

export interface ModuleDescriptorValidationResult {
  valid: boolean;
  descriptor: RefineryModuleDescriptor | null;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function expectNonEmptyString(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${path} must be a non-empty string`);
  }
}

export function validateRefineryModuleDescriptor(value: unknown): ModuleDescriptorValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return {
      valid: false,
      descriptor: null,
      errors: ["descriptor must be an object"],
    };
  }

  if (value.schemaVersion !== refineryModuleDescriptorSchemaVersion) {
    errors.push(`schemaVersion must be ${refineryModuleDescriptorSchemaVersion}`);
  }
  if (!refineryModuleKinds.includes(value.kind as RefineryModuleKind)) {
    errors.push(`kind must be one of ${refineryModuleKinds.join(", ")}`);
  }
  expectNonEmptyString(value.name, "name", errors);
  expectNonEmptyString(value.version, "version", errors);
  expectNonEmptyString(value.entrypoint, "entrypoint", errors);
  if (!Array.isArray(value.capabilities)) {
    errors.push("capabilities must be an array");
  } else {
    value.capabilities.forEach((capability, index) => {
      expectNonEmptyString(capability, `capabilities[${index}]`, errors);
    });
  }

  return {
    valid: errors.length === 0,
    descriptor: errors.length === 0
      ? {
        schemaVersion: refineryModuleDescriptorSchemaVersion,
        kind: value.kind as RefineryModuleKind,
        name: value.name as string,
        version: value.version as string,
        entrypoint: value.entrypoint as string,
        capabilities: value.capabilities as string[],
      }
      : null,
    errors,
  };
}
