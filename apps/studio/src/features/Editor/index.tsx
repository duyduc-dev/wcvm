import type { IWcvmProject } from "@/services/wcvm/model";

interface IProps {
  project: IWcvmProject;
}

const Editor = ({ project }: IProps) => {
  return <div>proj: {project.path}</div>;
};

export default Editor;
