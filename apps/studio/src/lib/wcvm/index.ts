import { toast } from "@/components/ui/toast";
import { boot, type IWcvm } from "wcvm";

let WcvmInstance: IWcvm;

const bootWcvm = async () => {
  WcvmInstance = boot({
    persist: true,
  });

  if (import.meta.env.DEV) {
    WcvmInstance.diagnostics.onEvent((e) => {
      console.log(`[bootWcvm][${e.timestamp}] ~ ${e.type} ~ `, e.payload);
    });
  }

  await toast.promise(WcvmInstance.ready, {
    loading: "Initializing WCVM ...",
    success: () => "Initialized WCVM successfully",
    error: "Could not initialize WCVM",
  });
};

const getWcvmInstance = () => {
  if (!WcvmInstance) {
    throw new Error("WcvmInstance is not ready");
  }

  return WcvmInstance;
};

export { bootWcvm, getWcvmInstance };
