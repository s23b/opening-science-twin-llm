/** Maps approved Ark site resources to the existing panel rows without inferring calls. */
import { z } from "zod";

import { buildsAgree, normaliseBuild } from "@/packages/genome-reference/build";

import { fhirId } from "./fhir-id";
import {
  isRsidGenotype,
  RSID_GENOTYPES_GRANTS,
  RSID_PANEL,
  type RsidGenotypeRow,
} from "./rsid-genotypes";

/** LOINC components and answers used by the Genomics Reporting IG STU3 profiles. */
const LOINC = "http://loinc.org";
const DBSNP = "http://www.ncbi.nlm.nih.gov/projects/SNP";
const GENOTYPE = "84413-4";
const VARIANT = "69548-6";
const CHROMOSOME = "48000-4";
const ASSEMBLY = "62374-4";
const COORDINATES = "92822-6";
const RANGE = "81254-5";
const REFERENCE = "69547-8";
const ALTERNATE = "69551-0";
const ALLELIC_STATE = "53034-5";
const CHANGE_TYPE = "48019-4";
const VARIATION = "81252-9";
const PRESENT = "LA9633-4";
const ABSENT = "LA9634-2";
const ONE_BASED = "LA30102-0";
const ASSEMBLIES: Readonly<Record<string, string>> = {
  "LA26806-2": "GRCh38",
  "LA14029-5": "GRCh37",
};
/** LL2938-0 contains 24 nuclear chromosomes and no mitochondrial answer. */
const CHROMOSOMES = [
  "LA21254-0",
  "LA21255-7",
  "LA21256-5",
  "LA21257-3",
  "LA21258-1",
  "LA21259-9",
  "LA21260-7",
  "LA21261-5",
  "LA21262-3",
  "LA21263-1",
  "LA21264-9",
  "LA21265-6",
  "LA21266-4",
  "LA21267-2",
  "LA21268-0",
  "LA21269-8",
  "LA21270-6",
  "LA21271-4",
  "LA21272-2",
  "LA21273-0",
  "LA21274-8",
  "LA21275-5",
  "LA21276-3",
  "LA21277-1",
] as const;

/** Only normalized sequence alleles may supply a reference or alternate. */
const SEQUENCE = /^[ACGTN]+$/;
const UUID_URL =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const concept = z.looseObject({
  text: z.string().optional(),
  coding: z.array(z.looseObject({ system: z.string(), code: z.string() })).optional(),
});
const component = z.looseObject({
  code: concept,
  valueCodeableConcept: concept.optional(),
  valueString: z.string().optional(),
  valueRange: z
    .looseObject({
      low: z.looseObject({ value: z.number().int().positive().safe() }),
      high: z.looseObject({ value: z.number().int().positive().safe() }),
    })
    .optional(),
});
const observation = z.looseObject({
  resourceType: z.literal("Observation"),
  id: z.string(),
  status: z.literal("final"),
  code: concept,
  component: z.array(component),
  valueCodeableConcept: concept.optional(),
  derivedFrom: z
    .array(z.looseObject({ reference: z.string().regex(UUID_URL) }))
    .optional(),
});
const collection = z.looseObject({
  resourceType: z.literal("Bundle"),
  type: z.literal("collection"),
  entry: z
    .array(
      z.looseObject({
        fullUrl: z.string().regex(UUID_URL),
        resource: observation,
      }),
    )
    .default([]),
});

/** Validated resource fields needed for the panel join. */
type Observation = z.infer<typeof observation>;
/** A parse failure carries a fixed rule, never a value from the Bundle. */
class FhirIssue extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
/** Stops parsing without putting personal values in the failure. */
const refuse = (code = "report-unreadable"): never => {
  throw new FhirIssue(code);
};

/** Reads exactly one LOINC coding, ignoring codings from other systems. */
const loinc = (value: z.infer<typeof concept> | undefined): string => {
  const codes = value?.coding?.filter((coding) => coding.system === LOINC) ?? [];
  return codes.length === 1 ? codes[0]!.code : refuse();
};

/** Reads one component and refuses duplicate component codes. */
const part = (
  resource: Observation,
  code: string,
): z.infer<typeof component> | undefined => {
  const found = resource.component.filter((entry) => loinc(entry.code) === code);
  return found.length > 1 ? refuse() : found[0];
};

/** Reads each dbSNP identifier while preserving the distinction from missing identifiers. */
const rsidsOf = (resource: Observation): Set<string> => {
  const ids = new Set<string>();
  for (const component of resource.component.filter(
    (part) => loinc(part.code) === VARIATION,
  )) {
    const codes =
      component.valueCodeableConcept?.coding?.filter((code) => code.system === DBSNP) ??
      [];
    if (
      codes.length !== 1 ||
      !/^rs(?:0|[1-9]\d*)$/.test(codes[0]!.code) ||
      ids.has(codes[0]!.code)
    )
      refuse();
    ids.add(codes[0]!.code);
  }
  return ids;
};

/** Reads a site's GRCh38 location and refuses inconsistent assembly components. */
const siteOf = (resource: Observation) => {
  const assembly = part(resource, ASSEMBLY)?.valueCodeableConcept;
  const coding = assembly?.coding?.filter((code) => code.system === LOINC) ?? [];
  if (coding.length > 1) refuse();
  const family = coding[0] === undefined ? undefined : ASSEMBLIES[coding[0].code];
  if (coding.length !== 0 && family === undefined) refuse("BUILD_UNKNOWN");
  const build = assembly?.text?.trim() || family;
  if (!build || normaliseBuild(build) === null) refuse("BUILD_UNKNOWN");
  if (family && !buildsAgree(build!, family)) refuse("BUILD_MISMATCH");
  if (normaliseBuild(build) !== "GRCh38") refuse("BUILD_MISMATCH");
  const chromosomeCode = loinc(part(resource, CHROMOSOME)?.valueCodeableConcept);
  const chromosomeIndex = CHROMOSOMES.findIndex((code) => code === chromosomeCode);
  if (chromosomeIndex < 0) refuse();
  const chromosome =
    chromosomeIndex < 22
      ? `chr${chromosomeIndex + 1}`
      : chromosomeIndex === 22
        ? "chrX"
        : "chrY";
  if (loinc(part(resource, COORDINATES)?.valueCodeableConcept) !== ONE_BASED) refuse();
  const range = part(resource, RANGE)?.valueRange;
  if (!range || range.low.value !== range.high.value) refuse();
  return {
    chromosome,
    position: range!.low.value,
    build: build!,
    key: `${chromosome}:${range!.low.value}`,
  };
};

/** Panel rows and the assembly named by the resources, or a content-free refusal. */
export type RsidFhirParse =
  | Readonly<{ ok: true; rows: readonly RsidGenotypeRow[]; arkBuild: string | null }>
  | Readonly<{ ok: false; issue: string }>;

/** Joins sites by their Variant identifiers, or rsID-path ids when no Variant exists. */
export const parseRsidFhir = (
  bundle: unknown,
  paths: readonly string[],
): RsidFhirParse => {
  try {
    const parsed = collection.safeParse(bundle);
    if (!parsed.success) refuse();
    if (
      new Set(paths).size !== paths.length ||
      paths.some((path) => !RSID_GENOTYPES_GRANTS.includes(path))
    )
      refuse();
    const entries = parsed.data!.entry;
    const resources = new Map(entries.map((entry) => [entry.fullUrl, entry.resource]));
    if (resources.size !== entries.length) refuse();
    const genotypes = new Map<string, Observation>();
    const usedVariants = new Set<string>();
    let arkBuild: string | null = null;
    for (const { fullUrl, resource } of entries) {
      if (fullUrl !== `urn:uuid:${resource.id}`) refuse();
      const site = siteOf(resource);
      if (arkBuild && !buildsAgree(arkBuild, site.build)) refuse("BUILD_MISMATCH");
      if (arkBuild === null || /\.p\d+$/i.test(site.build)) arkBuild = site.build;
      const code = loinc(resource.code);
      if (code === GENOTYPE) {
        if (genotypes.has(site.key)) refuse();
        genotypes.set(site.key, resource);
      } else if (code !== VARIANT) refuse();
    }

    const matched = new Map<
      string,
      ReturnType<typeof siteOf> & { genotype: Observation }
    >();
    for (const [key, genotype] of genotypes) {
      const links = genotype.derivedFrom?.map((link) => link.reference) ?? [];
      if (new Set(links).size !== links.length) refuse();
      let identifiers: Set<string> | undefined;
      for (const link of links) {
        const variant = resources.get(link);
        if (!variant || loinc(variant.code) !== VARIANT || siteOf(variant).key !== key)
          refuse();
        const rsids = rsidsOf(variant!);
        if (
          identifiers &&
          (identifiers.size !== rsids.size ||
            [...identifiers].some((rsid) => !rsids.has(rsid)))
        )
          refuse();
        identifiers = rsids;
      }
      const candidates = RSID_PANEL.filter(
        (entry) =>
          paths.includes(`v1/genome/rsids/${entry.rsid}`) &&
          (identifiers === undefined
            ? fhirId(`v1/genome/rsids/${entry.rsid}/fhir/genotype`) === genotype.id
            : identifiers.has(entry.rsid)),
      );
      if (candidates.length !== 1 || matched.has(candidates[0]!.rsid)) refuse();
      matched.set(candidates[0]!.rsid, { ...siteOf(genotype), genotype });
    }

    const rows = RSID_PANEL.map((entry): RsidGenotypeRow => {
      const path = `v1/genome/rsids/${entry.rsid}`;
      if (!paths.includes(path))
        return {
          rsid: entry.rsid,
          chromosome: null,
          position: null,
          reference: null,
          genotype: null,
          granted: false,
        };
      const site = matched.get(entry.rsid);
      const genotype = site?.genotype;
      let reference = entry.ref;
      let text: string | null = null;
      if (genotype) {
        const raw = genotype.valueCodeableConcept?.text;
        if (!raw || !isRsidGenotype(raw)) refuse();
        const alleles = raw!.split(/[/|]/).filter(Boolean);
        text = alleles.every((allele) => allele === ".") ? null : raw!;
        const links = genotype.derivedFrom?.map((link) => link.reference) ?? [];
        if (new Set(links).size !== links.length) refuse();
        const alternates = new Set<string>();
        let absent = false;
        let observedReference: string | undefined;
        for (const link of links) {
          const variant = resources.get(link);
          if (
            !variant ||
            loinc(variant.code) !== VARIANT ||
            siteOf(variant).key !== site!.key
          )
            refuse();
          const ref = part(variant!, REFERENCE)?.valueString;
          if (
            !ref ||
            !SEQUENCE.test(ref) ||
            (observedReference !== undefined && observedReference !== ref)
          )
            refuse();
          observedReference = ref;
          const state = loinc(variant!.valueCodeableConcept);
          const alt = part(variant!, ALTERNATE)?.valueString;
          if (state === ABSENT) {
            if (
              links.length !== 1 ||
              alt !== undefined ||
              part(variant!, ALLELIC_STATE) ||
              part(variant!, CHANGE_TYPE)
            )
              refuse();
            absent = true;
          } else if (
            state === PRESENT &&
            alt &&
            SEQUENCE.test(alt) &&
            alt !== ref &&
            !alternates.has(alt)
          ) {
            alternates.add(alt);
          } else refuse();
          usedVariants.add(link);
        }
        reference = observedReference ?? entry.ref;
        const expected = new Set(
          alleles.filter((allele) => SEQUENCE.test(allele) && allele !== reference),
        );
        if (
          expected.size !== alternates.size ||
          [...expected].some((alt) => !alternates.has(alt))
        )
          refuse();
        const fullyReference = alleles.every((allele) => allele === reference);
        if (absent !== fullyReference || (text === null && links.length !== 0)) refuse();
      }
      return {
        rsid: entry.rsid,
        chromosome: site?.chromosome ?? entry.chrom,
        position: site?.position ?? entry.pos,
        reference,
        genotype: text,
      };
    });
    if (
      entries.some(
        ({ fullUrl, resource }) =>
          loinc(resource.code) === VARIANT && !usedVariants.has(fullUrl),
      )
    )
      refuse();
    return { ok: true, rows, arkBuild };
  } catch (error) {
    if (error instanceof FhirIssue) return { ok: false, issue: error.code };
    throw error;
  }
};
