import { zodResolver } from "@hookform/resolvers/zod";
import { SpinnerIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  buildProjectPath,
  DEFAULT_PROJECTS_DIR,
  slugify,
  slugifyLive,
} from "../CreateBlankTemplateDialog/service";
import { useNavigate } from "@tanstack/react-router";
import { useWcvmProjectStore } from "@/stores/useWcvmProjectStore";
import {
  FRAMEWORK_OPTIONS,
  TEMPLATE_CATEGORIES,
  type IFrameworkOption,
} from "./constants";

const createTemplateSchema = z.object({
  framework: z.enum(
    FRAMEWORK_OPTIONS.map((f) => f.id) as [string, ...string[]],
  ),
  projectName: z.string().trim().min(1, "Project name is required"),
  directory: z.string().trim().min(1, "Directory is required"),
});

type CreateTemplateValues = z.infer<typeof createTemplateSchema>;

const CreateTemplateDialog = () => {
  const navigate = useNavigate({ from: "/" });
  const createProject = useWcvmProjectStore((s) => s.addProject);
  const [progress, setProgress] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setValue,
    control,
    formState: { errors, dirtyFields, isSubmitting },
  } = useForm<CreateTemplateValues>({
    resolver: zodResolver(createTemplateSchema),
    defaultValues: {
      framework: FRAMEWORK_OPTIONS[0].id,
      projectName: "",
      directory: "",
    },
  });

  const framework = useWatch({ control, name: "framework" });
  const projectName = useWatch({ control, name: "projectName" });
  const directory = useWatch({ control, name: "directory" });
  const projectPath =
    directory && projectName ? buildProjectPath(directory, projectName) : "";
  const selected =
    FRAMEWORK_OPTIONS.find((f) => f.id === framework) ?? FRAMEWORK_OPTIONS[0];
  const [activeCategory, setActiveCategory] = useState(selected.category);

  const onSubmit = async (values: CreateTemplateValues) => {
    setFailure(null);
    const projectPath = buildProjectPath(
      values.directory,
      slugify(values.projectName),
    );
    const { isFailure, message, project } = await createProject(
      projectPath,
      values.framework as IFrameworkOption["id"],
      setProgress,
    );
    setProgress(null);

    if (isFailure) {
      setFailure(message);
    } else {
      navigate({
        to: "/editor/$id",
        params: { id: project!.id },
      });
    }
  };

  useEffect(() => {
    if (dirtyFields.directory) {
      return;
    }

    setValue("directory", projectName ? DEFAULT_PROJECTS_DIR : "");
  }, [projectName, dirtyFields.directory, setValue]);

  if (isSubmitting) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>
            <div className="flex items-center gap-2">
              <selected.icon size={20} />{" "}
              <p>Creating {selected.label} project</p>
            </div>
          </DialogTitle>
          <DialogDescription>
            Scaffolding a real Vite + {selected.label} + {selected.description} project —
            this can take up to a minute the first time.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
          <SpinnerIcon size={16} className="animate-spin" />
          <span>{progress}</span>
        </div>
      </>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <DialogHeader>
        <DialogTitle>New project from template</DialogTitle>
        <DialogDescription>
          Scaffolded for real with <code>npm create vite@latest</code>.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup className="mt-4">
        <Field>
          <FieldLabel>Framework</FieldLabel>
          <Controller
            control={control}
            name="framework"
            render={({ field }) => (
              <Tabs
                value={activeCategory}
                onValueChange={(value) =>
                  setActiveCategory(value as typeof activeCategory)
                }
              >
                <TabsList variant="line" className="mb-2 w-full">
                  {TEMPLATE_CATEGORIES.map((category) => (
                    <TabsTrigger key={category} value={category}>
                      {category}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {TEMPLATE_CATEGORIES.map((category) => (
                  <TabsContent key={category} value={category}>
                    <div className="grid grid-cols-2 gap-2">
                      {FRAMEWORK_OPTIONS.filter(
                        (option) => option.category === category,
                      ).map((option) => {
                        const isSelected = field.value === option.id;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            aria-pressed={isSelected}
                            onClick={() => field.onChange(option.id)}
                            className={cn(
                              "flex flex-col items-center gap-1 border p-3 text-center transition-all hover:bg-accent",
                              isSelected && "border-primary bg-accent",
                            )}
                          >
                            <option.icon size={24} />
                            <span className="text-sm font-medium">
                              {option.label}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {option.description}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </TabsContent>
                ))}
              </Tabs>
            )}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="template-project-name">Project Name</FieldLabel>
          <Controller
            control={control}
            name="projectName"
            render={({ field }) => (
              <Input
                id="template-project-name"
                type="text"
                placeholder={`my-${selected.label.toLowerCase()}-app`}
                aria-invalid={!!errors.projectName}
                {...field}
                onChange={(e) => field.onChange(slugifyLive(e.target.value))}
                onBlur={(e) => {
                  field.onChange(slugify(e.target.value));
                  field.onBlur();
                }}
              />
            )}
          />
          <FieldError errors={[errors.projectName]} />
        </Field>
        <Field>
          <FieldLabel htmlFor="template-directory">Directory</FieldLabel>
          <Input
            id="template-directory"
            type="text"
            placeholder={`/home/user/projects/my-${selected.label.toLowerCase()}-app`}
            aria-invalid={!!errors.directory}
            {...register("directory")}
          />
          <FieldError errors={[errors.directory]} />
          {projectPath && (
            <FieldDescription>
              Project will be created at {projectPath}
            </FieldDescription>
          )}
        </Field>
      </FieldGroup>
      {failure && (
        <p className="mt-4 text-sm text-destructive whitespace-pre-wrap">
          {failure}
        </p>
      )}
      <DialogFooter className="mt-5">
        <DialogClose
          render={
            <Button type="button" variant="outline">
              Close
            </Button>
          }
        />
        <Button type="submit">Create</Button>
      </DialogFooter>
    </form>
  );
};

export default CreateTemplateDialog;
