import { getWcvmInstance } from "@/lib/wcvm";

export interface BlankTemplateCreationResult {
  isFailure: boolean;
  message: string;
  type?: string;
}

const createBlankTemplateProject = async (
  projectPath: string,
): Promise<BlankTemplateCreationResult> => {
  const wc = getWcvmInstance();

  const isExisting = await wc.fs.exists(projectPath);
  if (isExisting) {
    return {
      isFailure: true,
      message: `A project already exists at ${projectPath}`,
      type: "projectName",
    };
  }

  await wc.fs.mkdir(projectPath, { recursive: true });

  const projectName = projectPath.split("/").at(-1);

  await wc.fs.mount(
    {
      src: {
        directory: {
          "index.js": {
            file: {
              contents: `console.log("Hello from ${projectName}!");\n`,
            },
          },
        },
      },
      "package.json": {
        file: {
          contents: `{
  "name": "${projectName}",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node ./src/index.js"
  }
}
`,
        },
      },
      "README.md": {
        file: {
          contents: `
      # ${projectName}

A blank project created.
        `,
        },
      },
    },
    projectPath,
  );

  return {
    isFailure: false,
    message: "ok",
  };
};

export { createBlankTemplateProject };
