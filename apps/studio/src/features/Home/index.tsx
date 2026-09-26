import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { TEMPLATES } from "./constants";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";

const Home = () => {
  return (
    <div>
      <div className="flex gap-4">
        {TEMPLATES.map((template, id) => (
          <Dialog key={id}>
            <DialogTrigger
              nativeButton={false}
              render={
                <Card className="w-60 cursor-pointer hover:bg-neutral-50 transition-all">
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

export default Home;
