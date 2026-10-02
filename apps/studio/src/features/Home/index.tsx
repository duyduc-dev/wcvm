import { useEffect } from "react";
import { startTourOnFirstVisit } from "@/lib/tour";
import CardTemplate from "./CardTemplate";
import RecentProjects from "./RecentProjects";

const Home = () => {
  // A first-time visitor gets the tour once; the "Tour" button in the header replays it.
  useEffect(() => startTourOnFirstVisit("home"), []);

  return (
    <div className="flex items-center justify-center w-full">
      <div className="w-full max-w-180">
        <CardTemplate />
        <RecentProjects />
      </div>
    </div>
  );
};

export default Home;
