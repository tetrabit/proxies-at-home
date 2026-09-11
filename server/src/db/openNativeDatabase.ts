import Database from 'better-sqlite3';

export function openNativeDatabase(filename: string): Database.Database {
  const nativeBinding = process.env.PROXXIED_SQLITE_NATIVE_BINDING;

  return new Database(filename, nativeBinding ? { nativeBinding } : undefined);
}
