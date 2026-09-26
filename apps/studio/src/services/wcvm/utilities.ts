import { getWcvmInstance } from "@/lib/wcvm";

export const clearAllFileSystem = () => {
  return getWcvmInstance().fs.reset();
};

export const removeFolderByPath = (path: string) => {
  getWcvmInstance().fs.rm(path, { recursive: true });
};
