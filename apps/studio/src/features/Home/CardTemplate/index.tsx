import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Dialog, DialogTrigger, DialogContent } from "@/components/ui/dialog";
import { TEMPLATES } from "./constants";
import { SuitcaseIcon } from "@phosphor-icons/react";

const CardTemplate = () => {
  return (
    <div>
      <div className="flex items-center gap-2">
        <SuitcaseIcon size={20} />
        <p className="text-sm">Templates</p>
      </div>
      <div className="flex flex-col sm:flex-row gap-4 mt-5">
        {TEMPLATES.map((template, id) => (
          <Dialog key={id}>
            <DialogTrigger
              nativeButton={false}
              render={
                <Card className="w-full sm:w-60 cursor-pointer hover:bg-neutral-50 transition-all">
                  <CardHeader>
                    <template.icon size={32} />
                    <CardTitle>{template.title}</CardTitle>
                    <CardDescription>{template.description}</CardDescription>
                  </CardHeader>
                </Card>
              }
            ></DialogTrigger>
            <DialogContent>
              <template.dialog />
            </DialogContent>
          </Dialog>
        ))}
      </div>
    </div>
  );
};

export default CardTemplate;
