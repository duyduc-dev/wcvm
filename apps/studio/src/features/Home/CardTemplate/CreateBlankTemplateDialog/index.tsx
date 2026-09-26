import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
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
import { FilePlusIcon } from "@phosphor-icons/react";
import {
  buildProjectPath,
  DEFAULT_PROJECTS_DIR,
  slugify,
  slugifyLive,
} from "./service";
import { useNavigate } from "@tanstack/react-router";
import { useWcvmProjectStore } from "@/stores/useWcvmProjectStore";

const createBlankTemplateSchema = z.object({
  projectName: z.string().trim().min(1, "Project name is required"),
  directory: z.string().trim().min(1, "Directory is required"),
});

type CreateBlankTemplateValues = z.infer<typeof createBlankTemplateSchema>;

const CreateBlankTemplateDialog = () => {
  const navigate = useNavigate({ from: "/" });
  const createProject = useWcvmProjectStore((s) => s.addProject);
  const {
    register,
    handleSubmit,
    setValue,
    setError,
    control,
    formState: { errors, dirtyFields },
  } = useForm<CreateBlankTemplateValues>({
    resolver: zodResolver(createBlankTemplateSchema),
    defaultValues: { projectName: "", directory: "" },
  });

  const projectName = useWatch({ control, name: "projectName" });
  const directory = useWatch({ control, name: "directory" });
  const projectPath =
    directory && projectName ? buildProjectPath(directory, projectName) : "";

  const onSubmit = async (values: CreateBlankTemplateValues) => {
    const projectPath = buildProjectPath(
      values.directory,
      slugify(values.projectName),
    );
    const { isFailure, message, type, project } =
      await createProject(projectPath);

    if (isFailure) {
      if (type === "projectName") {
        setError("projectName", {
          message,
        });
      } else {
        setError("projectName", {
          message: `Error occurred at ${projectPath}`,
        });
      }
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

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <DialogHeader>
        <DialogTitle>
          <div className="flex items-center gap-2">
            <FilePlusIcon size={20} /> <p>New blank project</p>
          </div>
        </DialogTitle>
        <DialogDescription>
          An empty project you can build up from scratch.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup className="mt-4">
        <Field>
          <FieldLabel htmlFor="project-name">Project Name</FieldLabel>
          <Controller
            control={control}
            name="projectName"
            render={({ field }) => (
              <Input
                id="project-name"
                type="text"
                placeholder="new-blank-app"
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
          <FieldLabel htmlFor="directory">Directory</FieldLabel>
          <Input
            id="directory"
            type="text"
            placeholder="/home/user/projects/new-blank-app"
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

export default CreateBlankTemplateDialog;
