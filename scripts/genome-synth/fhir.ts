/** Synthetic Ark export fixture, derived only from the seeded genome catalog. */
import { writeFile } from "node:fs/promises";

import { fhirId } from "@/packages/ark-adapter/fhir-id";

import { ARK_PANEL } from "./ark-report";
import { alleles, callsFor, type Call } from "./genotypes";
import { readCatalog } from "./read-catalog";

/** Public LOINC terminology for the Genomics Reporting IG STU3 site profiles. */
const LOINC = "http://loinc.org";
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
];
const ACCESSION_VERSIONS = [
  11, 12, 12, 12, 10, 12, 14, 11, 12, 11, 10, 12, 11, 9, 10, 10, 11, 10, 10, 11, 9, 11,
];

/** A coded concept with the public display supplied explicitly. */
const concept = (code: string, display: string, system = LOINC) => ({
  coding: [{ system, code, display }],
});

/** Shared location components for an autosomal synthetic site on GRCh38.p14. */
const location = ({ variant }: Call) => {
  const chromosome = Number(variant.chrom.slice(3));
  return [
    {
      code: concept(
        "48000-4",
        "Chromosome [Identifier] in Blood or Tissue by Molecular genetics method",
      ),
      valueCodeableConcept: concept(
        CHROMOSOMES[chromosome - 1]!,
        `Chromosome ${chromosome}`,
      ),
    },
    {
      code: concept("62374-4", "Human reference sequence assembly version"),
      valueCodeableConcept: { ...concept("LA26806-2", "GRCh38"), text: "GRCh38.p14" },
    },
    {
      code: concept("48013-7", "Genomic reference sequence [ID]"),
      valueCodeableConcept: {
        coding: [
          {
            system: "http://www.ncbi.nlm.nih.gov/refseq",
            code: `NC_${String(chromosome).padStart(6, "0")}.${ACCESSION_VERSIONS[chromosome - 1]}`,
          },
        ],
      },
    },
    {
      code: concept("92822-6", "Genomic coordinate system [Type]"),
      valueCodeableConcept: concept("LA30102-0", "1-based character counting"),
    },
    {
      code: concept("81254-5", "Genomic allele start-end"),
      valueRange: { low: { value: variant.pos }, high: { value: variant.pos } },
    },
    {
      code: concept("48002-0", "Genomic source class [Type]"),
      valueCodeableConcept: concept("LA6683-2", "Germline"),
    },
  ];
};

/** One resource with deterministic identity and laboratory categories. */
const resource = (id: string, code: string, display: string, profile: string) => ({
  resourceType: "Observation",
  id,
  meta: {
    profile: [`http://hl7.org/fhir/uv/genomics-reporting/StructureDefinition/${profile}`],
  },
  status: "final",
  category: [
    concept(
      "laboratory",
      "Laboratory",
      "http://terminology.hl7.org/CodeSystem/observation-category",
    ),
    concept("GE", "Genetics", "http://terminology.hl7.org/CodeSystem/v2-0074"),
  ],
  code: concept(code, display),
});

/** A collection shaped as an approved panel export, containing no real person's data. */
export const fhirFor = (calls: readonly Call[]) => {
  const entry = ARK_PANEL.flatMap((rsid) => {
    const call = calls.find((entry) => entry.variant.rsid === rsid);
    if (!call) throw new Error("synthetic panel site missing");
    const { variant, altCopies } = call;
    const path = `v1/genome/rsids/${rsid}/fhir`;
    const genotypeId = fhirId(`${path}/genotype`);
    const variantId = fhirId(`${path}/variant/1`);
    const genotype = {
      fullUrl: `urn:uuid:${genotypeId}`,
      resource: {
        ...resource(genotypeId, "84413-4", "Genotype display name", "genotype"),
        valueCodeableConcept: { text: alleles(call) ?? "./." },
        ...(altCopies === null
          ? {}
          : { derivedFrom: [{ reference: `urn:uuid:${variantId}` }] }),
        component: location(call),
      },
    };
    if (altCopies === null) return [genotype];
    const present = altCopies > 0;
    return [
      genotype,
      {
        fullUrl: `urn:uuid:${variantId}`,
        resource: {
          ...resource(variantId, "69548-6", "Genetic variant assessment", "variant"),
          valueCodeableConcept: concept(
            present ? "LA9633-4" : "LA9634-2",
            present ? "Present" : "Absent",
          ),
          component: [
            ...location(call),
            {
              code: concept("69547-8", "Genomic ref allele [ID]"),
              valueString: variant.ref,
            },
            ...(present
              ? [
                  {
                    code: concept("69551-0", "Genomic alt allele [ID]"),
                    valueString: variant.alt,
                  },
                  {
                    code: concept("53034-5", "Allelic state"),
                    valueCodeableConcept: concept(
                      altCopies === 1 ? "LA6706-1" : "LA6705-3",
                      altCopies === 1 ? "Heterozygous" : "Homozygous",
                    ),
                  },
                  {
                    code: concept("48019-4", "DNA change type"),
                    valueCodeableConcept: concept(
                      "SO:0001483",
                      "SNV",
                      "http://www.sequenceontology.org",
                    ),
                  },
                ]
              : []),
            {
              code: concept("81252-9", "Discrete genetic variant"),
              valueCodeableConcept: {
                coding: [
                  {
                    system: "http://www.ncbi.nlm.nih.gov/projects/SNP",
                    code: variant.rsid,
                  },
                ],
              },
            },
          ],
        },
      },
    ];
  });
  const bundle = { resourceType: "Bundle", type: "collection", entry };
  return {
    task: "3",
    paths: ARK_PANEL.map((rsid) => `v1/genome/rsids/${rsid}`),
    media: "application/fhir+json; fhirVersion=4.0",
    bundle_bytes: Buffer.byteLength(JSON.stringify(bundle)),
    bundle,
    duration_seconds: 0,
  };
};

if (Boolean((import.meta as { main?: boolean }).main)) {
  const out = process.argv[process.argv.indexOf("--out") + 1];
  if (!process.argv.includes("--out") || !out) throw new Error("Use --out FILE");
  const calls = callsFor("080b069b-5108-46b6-ecef-6aacd3b9ef3f", await readCatalog());
  await writeFile(out, JSON.stringify(fhirFor(calls)));
}
