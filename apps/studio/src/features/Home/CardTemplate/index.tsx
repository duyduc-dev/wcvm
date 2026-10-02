import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Dialog, DialogTrigger, DialogContent } from "@/components/ui/dialog";
import { TEMPLATES } from "./constants";
import { CompassIcon, SuitcaseIcon } from "@phosphor-icons/react";
import { isTourActive, startTour } from "@/lib/tour";

const CardTemplate = () => {
  return (
    <div data-tour="templates">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <SuitcaseIcon size={20} />
          <p className="text-sm">Templates</p>
        </div>
        <button
          type="button"
          data-tour="guide-react"
          onClick={() => startTour("create-react")}
          className="flex items-center gap-1.5 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <CompassIcon className="size-3.5" />
          New here? Guide me through creating a React app
        </button>
      </div>
      <div className="flex flex-col sm:flex-row gap-4 mt-5">
        {TEMPLATES.map((template, id) => (
          <Dialog
            key={id}
            // The tour's popover sits outside the dialog, so clicking "Next" would count as an
            // outside press and close the dialog under it. Only the tour's own presses are ignored.
            onOpenChange={(open, details) => {
              if (!open && isTourActive() && details.reason === "outside-press") details.cancel();
            }}
          >
            <DialogTrigger
              nativeButton={false}
              render={
                <Card
                  data-template-card={template.title.toLowerCase().replace(/\W+/g, "-")}
                  className="w-full sm:w-60 cursor-pointer hover:bg-accent transition-all"
                >
                  <CardHeader>
                    <template.icon size={32} />
                    <CardTitle>{template.title}</CardTitle>
                    <CardDescription>{template.description}</CardDescription>
                  </CardHeader>
                </Card>
              }
            ></DialogTrigger>
            <DialogContent className="sm:max-w-xl">
              <template.dialog />
            </DialogContent>
          </Dialog>
        ))}
      </div>
    </div>
  );
};

export default CardTemplate;
