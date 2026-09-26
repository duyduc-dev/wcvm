import type { IWcvmProject } from "@/services/wcvm/model";
import { AppShell } from "./ide/AppShell";
import { IdeProvider } from "./ide/controller/IdeProvider";

interface IProps {
  project: IWcvmProject;
}

const Editor = ({ project }: IProps) => {
  return (
    <div className="h-screen w-screen overflow-hidden">
      <IdeProvider rootPath={project.path}>
        <AppShell />
      </IdeProvider>
    </div>
  );
};

export default Editor;
