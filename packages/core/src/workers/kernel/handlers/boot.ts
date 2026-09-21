import { KernelMessage } from "../../../bridges/models";
import { createKernelHost, IKernelHost } from "../../../kernel";
import { RouteHandler } from "../router";

interface IPrams {
  setKernel: (kernel: IKernelHost) => void;
  onPostMessage: (message: KernelMessage) => void;
}

const boot = ({ setKernel, onPostMessage }: IPrams) => {
  const kernel = createKernelHost();
  setKernel(kernel);

  onPostMessage({
    type: "boot:exit",
  });
};

const bootHandler: RouteHandler = ({ stateManager, onPostMessage }) => {
  const setKernel = (kernel: IKernelHost) => stateManager.setState({ kernel });
  boot({
    setKernel,
    onPostMessage,
  });
};

export { bootHandler };
