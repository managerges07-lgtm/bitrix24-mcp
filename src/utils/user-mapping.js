import { readWorkspaceJson, writeWorkspaceJson } from './safe-path.js';

export function applyUserMapping(automations, mappingFilePath) {
  if (!mappingFilePath) return automations;

  const { data: mapping } = readWorkspaceJson(mappingFilePath);

  const str = JSON.stringify(automations);
  let result = str;
  for (const [sourceId, destId] of Object.entries(mapping)) {
    result = result.replaceAll(`"${sourceId}"`, `"${destId}"`);
    result = result.replaceAll(`:${sourceId}`, `:${destId}`);
  }
  return JSON.parse(result);
}

export function suggestUserMapping(sourceUsers, destUsers) {
  const mapping = {};
  for (const src of sourceUsers) {
    const match =
      destUsers.find(d => d.EMAIL === src.EMAIL) ||
      destUsers.find(d => `${d.NAME} ${d.LAST_NAME}`.trim() === `${src.NAME} ${src.LAST_NAME}`.trim());
    if (match) {
      mapping[src.ID] = match.ID;
    }
  }
  return mapping;
}

export function saveUserMapping(mapping, outputFile) {
  return writeWorkspaceJson(outputFile, mapping);
}
