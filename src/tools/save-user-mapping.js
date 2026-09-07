import { z } from 'zod';
import { saveUserMapping, suggestUserMapping } from '../utils/user-mapping.js';

export const saveUserMappingSchema = z.object({
  source_users: z.array(z.object({
    ID: z.string(),
    NAME: z.string().optional(),
    LAST_NAME: z.string().optional(),
    EMAIL: z.string().optional(),
  })).describe('Список пользователей исходной инстанции'),
  dest_users: z.array(z.object({
    ID: z.string(),
    NAME: z.string().optional(),
    LAST_NAME: z.string().optional(),
    EMAIL: z.string().optional(),
  })).describe('Список пользователей целевой инстанции'),
  output_file: z.string().describe('Путь для сохранения JSON сопоставления'),
});

export async function saveUserMappingTool({ source_users, dest_users, output_file }) {
  const mapping = suggestUserMapping(source_users, dest_users);

  const unmapped = source_users.filter(u => !mapping[u.ID]);

  const filePath = saveUserMapping(mapping, output_file);

  return {
    saved_to: filePath,
    mapped_count: Object.keys(mapping).length,
    unmapped_count: unmapped.length,
    mapping,
    unmapped_users: unmapped.map(u => ({
      id: u.ID,
      name: `${u.NAME || ''} ${u.LAST_NAME || ''}`.trim(),
      email: u.EMAIL,
    })),
    summary: `${Object.keys(mapping).length} пользователей сопоставлено, ${unmapped.length} без соответствия в целевой инстанции`,
    note: unmapped.length > 0
      ? 'Пользователей без сопоставления нужно назначить вручную. Автоматизации, которые на них ссылаются, вызовут предупреждения при применении.'
      : null,
  };
}
