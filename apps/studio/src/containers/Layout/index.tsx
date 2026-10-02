import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { type PropsWithChildren } from "react";
import { useTheme } from "@/hooks/use-theme";

const Layout = ({ children }: PropsWithChildren) => {
  const { isDark, toggleTheme } = useTheme();

  return (
    <SidebarProvider>
      {/* <AppSidebar /> */}
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center justify-between gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <div className="flex items-center gap-2 px-4">
            {/* <SidebarTrigger className="-ml-1" />
            <Separator
              orientation="vertical"
              className="mr-2 data-[orientation=vertical]:h-5"
            /> */}
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink href="/" className="flex items-center gap-2 font-semibold text-foreground">
                    <img src="/favicon.svg" alt="" width={24} height={24} className="size-6" />
                    WCVM Studio
                  </BreadcrumbLink>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            aria-label="Toggle theme"
            className="mr-4"
          >
            {isDark ? <MoonIcon /> : <SunIcon />}
          </Button>
        </header>
        <div className="flex flex-1 flex-col gap-4 p-4 pt-0">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
};

export default Layout;
