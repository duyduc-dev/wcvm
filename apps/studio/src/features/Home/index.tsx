import CardTemplate from "./CardTemplate";
import RecentProjects from "./RecentProjects";

const Home = () => {
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
